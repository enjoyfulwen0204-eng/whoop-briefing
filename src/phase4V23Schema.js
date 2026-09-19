import { R_SQL, sqlEnum } from './phase4V22Schema.js';

export const EPISODE_ACTIVE = ['OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING'];
export const EPISODE_STATES = [...EPISODE_ACTIVE,'RESOLVED','EXPIRED','INVALIDATED'];
export const INSIGHT_STATES = ['HYPOTHESIS','EMERGING','SUPPORTED','WEAKENED','RETIRED'];
export const INSIGHT_DISPOSITIONS = ['REJECTED','REFUTED','EXPIRED','INVALIDATED','SUPERSEDED','USER_DISMISSED'];
export const QUALITY_STATES = ['UNAVAILABLE','NO_DATA','DEGRADED','WARMING_UP','LIMITED','AVAILABLE'];
export const V23_TABLES = ['body_energy_results','body_energy_checkpoints','evidence_runs','evidence_items',
  'observation_episodes','episode_observations','episode_evidence','episode_events','episode_semantic_events','insight_revisions'];
export const V23_HEALTH_FIELDS = Object.freeze({
  body_energy_results: ['as_of_epoch_ms','as_of_utc','wake_at_utc','timezone','health_date','value','quality_state','confidence',
    'confidence_label','input_manifest_json','driver_json','missingness_json'],
  body_energy_checkpoints: ['checkpoint_bucket_start','checkpoint_as_of_epoch_ms','result_id'],
  evidence_runs: ['subject_key','window_start_utc','window_end_utc','as_of_utc','timezone','sample_count','exclusion_count',
    'unknown_eligible_days','eligible_observation_days','unknown_fraction','input_manifest_json','missingness_json','multiple_testing_family'],
  evidence_items: ['claim_key','direction','unit','effect','lower_bound','upper_bound','raw_significance','adjusted_significance',
    'exposed_count','confirmed_unexposed_count','unknown_count','effective_sample_count','quality','recency_weight','causal_status','provenance_json','confound_json'],
  observation_episodes: ['episode_type','domain','subject_key','direction','severity','current_confidence','current_novelty','explained_status',
    'explanation_evidence_item_id','explanation_context_id','first_observed_at','last_observed_at','last_material_change_at',
    'stabilization_started_at','health_window_start','health_window_end','timezone','explanation_json','current_context_json','max_semantic_severity_ordinal'],
  episode_observations: ['source_type','source_id','source_version','observed_at','health_date','normalized_value','unit','robust_z','meaningfulness','quality'],
  episode_evidence: ['relationship_type'], episode_events: ['reason','evidence_references_json'],
  episode_semantic_events: ['severity_ordinal','explained_uncertainty_key','claim_key','recommended_action_key'],
  insight_revisions: ['normalized_claim','supporting_evidence_ids_json','contradicting_evidence_ids_json','transition_reason'],
});
export const schemaIndex = (name, table, fields, unique = false, where = '') =>
  `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${fields})${where ? ` WHERE ${where}` : ''}`;
const generation = name => `${name} INTEGER NOT NULL CHECK(typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND 9007199254740991)`;
const fences = ['input_generation','lifecycle_generation','auth_generation'].map(generation).join(',');
const json = name => `${name} TEXT NULL CHECK(length(${name}) <= 262144)`;
const enumColumn = (name, values, nullable = true) => `${name} TEXT ${nullable ? 'NULL' : 'NOT NULL'} CHECK(${name} IN (${sqlEnum(values)}))`;
export const privacyChecks = `CHECK(content_state <> 'PRESENT' OR (privacy_artifact_id IS NOT NULL AND source_linkage_state = 'COMPLETE')),
  CHECK(content_state <> 'REDACTED' OR (health_content_redacted_at IS NOT NULL AND health_content_redaction_reason IS NOT NULL
    AND source_linkage_state = 'DISCONNECTED' AND content_digest_salt IS NULL))`;
const immutableColumns = {
  body_energy_results: ['result_id','result_lookup_key','algorithm_version','constants_version','baseline_version','metric_registry_version',
    'input_generation','lifecycle_generation','auth_generation','input_manifest_hash','result_hash','supersedes_result_id','created_at'],
  body_energy_checkpoints: ['checkpoint_id','checkpoint_lookup_key','checkpoint_kind','algorithm_version','input_generation','created_at'],
  evidence_runs: ['run_id','deterministic_run_key','method','algorithm_version','registry_version','evidence_contract_version',
    'input_generation','lifecycle_generation','auth_generation','promotion_confound_version','exposure_classification_version','factor_set_version','started_at'],
  evidence_items: ['evidence_item_id','run_id','item_key','exposure_classification_version','factor_set_version','supersedes_item_id','created_at'],
  observation_episodes: ['episode_id','fingerprint','episode_family_key','reopens_episode_id','reverses_episode_id','opened_at','created_at'],
  episode_observations: ['episode_id','observation_key','input_generation','added_at'],
  episode_evidence: ['episode_id','evidence_item_id','episode_revision','linked_at'],
  episode_events: ['episode_event_id','deterministic_event_key','episode_id','event_kind','from_state','to_state','expected_revision',
    'resulting_revision','input_generation','actor_type','created_at'],
  episode_semantic_events: ['episode_semantic_event_id','episode_id','resulting_revision','episode_event_id','event_kind',
    'predecessor_semantic_event_id','input_generation','lifecycle_generation','auth_generation','algorithm_version','created_at'],
  insight_revisions: ['insight_id','revision','status','lifecycle_disposition','evidence_contract_version',
    'input_generation','lifecycle_generation','auth_generation','created_at'],
};

export function buildV23(modeColumn, immutableMode) {
  const header = table => `CREATE TABLE IF NOT EXISTS ${table} (user_id TEXT NOT NULL, ${modeColumn}, ${R_SQL},`;
  const tail = key => `${privacyChecks}, PRIMARY KEY(user_id,execution_mode,${key}))`;
  const ddl = [
    `${header('body_energy_results')}
      result_id TEXT NOT NULL, result_lookup_key TEXT NOT NULL,
      as_of_epoch_ms INTEGER NULL CHECK(as_of_epoch_ms IS NULL OR (typeof(as_of_epoch_ms) = 'integer' AND abs(as_of_epoch_ms) <= 8640000000000000)),
      as_of_utc TEXT NULL, wake_at_utc TEXT NULL, timezone TEXT NULL, health_date TEXT NULL,
      value INTEGER NULL CHECK(value IS NULL OR (typeof(value) = 'integer' AND value BETWEEN 0 AND 100)),
      ${enumColumn('quality_state',QUALITY_STATES)}, confidence REAL NULL CHECK(confidence BETWEEN 0 AND 1),
      ${enumColumn('confidence_label',['HIGH','MEDIUM','LOW','INSUFFICIENT'])},
      algorithm_version TEXT NOT NULL, constants_version TEXT NOT NULL, baseline_version TEXT NOT NULL, metric_registry_version TEXT NOT NULL,
      ${fences}, ${json('input_manifest_json')}, ${json('driver_json')}, ${json('missingness_json')},
      input_manifest_hash TEXT NULL, result_hash TEXT NULL, invalidated_at TEXT NULL, invalidation_reason TEXT NULL,
      supersedes_result_id TEXT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,health_date,as_of_epoch_ms,algorithm_version,input_generation,execution_mode),
      UNIQUE(user_id,execution_mode,result_lookup_key),
      CHECK(content_state <> 'PRESENT' OR (as_of_epoch_ms IS NOT NULL AND as_of_utc IS NOT NULL AND health_date IS NOT NULL
        AND input_manifest_hash IS NOT NULL AND input_manifest_json IS NOT NULL AND quality_state IS NOT NULL)),
      ${tail('result_id')}`,
    `${header('body_energy_checkpoints')}
      checkpoint_id TEXT NOT NULL, checkpoint_kind TEXT NOT NULL CHECK(checkpoint_kind = 'PERIODIC_15M'),
      checkpoint_bucket_start INTEGER NULL, checkpoint_as_of_epoch_ms INTEGER NULL, result_id TEXT NULL,
      algorithm_version TEXT NOT NULL, ${generation('input_generation')}, created_at TEXT NOT NULL,
      checkpoint_lookup_key TEXT NOT NULL, UNIQUE(user_id,execution_mode,checkpoint_lookup_key),
      CHECK(content_state <> 'PRESENT' OR (checkpoint_bucket_start IS NOT NULL AND typeof(checkpoint_bucket_start) = 'integer'
        AND checkpoint_bucket_start % 900000 = 0 AND checkpoint_as_of_epoch_ms IS NOT NULL
        AND checkpoint_as_of_epoch_ms = checkpoint_bucket_start + 900000 AND result_id IS NOT NULL)),
      ${tail('checkpoint_id')}`,
    `${header('evidence_runs')}
      run_id TEXT NOT NULL, deterministic_run_key TEXT NOT NULL, subject_key TEXT NULL, method TEXT NOT NULL,
      window_start_utc TEXT NULL, window_end_utc TEXT NULL, as_of_utc TEXT NULL, timezone TEXT NULL,
      algorithm_version TEXT NOT NULL, registry_version TEXT NOT NULL, evidence_contract_version TEXT NOT NULL,
      ${fences}, input_manifest_hash TEXT NULL, sample_count INTEGER NULL CHECK(sample_count >= 0),
      exclusion_count INTEGER NULL CHECK(exclusion_count >= 0), unknown_eligible_days INTEGER NULL CHECK(unknown_eligible_days >= 0),
      eligible_observation_days INTEGER NULL CHECK(eligible_observation_days >= 0), unknown_fraction REAL NULL CHECK(unknown_fraction BETWEEN 0 AND 1),
      max_unknown_fraction_for_promotion REAL NOT NULL DEFAULT 0.50 CHECK(max_unknown_fraction_for_promotion = 0.50),
      promotion_confound_version TEXT NOT NULL, exposure_classification_version TEXT NOT NULL, factor_set_version TEXT NOT NULL,
      ${json('input_manifest_json')}, ${json('missingness_json')}, multiple_testing_family TEXT NULL,
      ${enumColumn('state',['STARTED','COMPLETED','FAILED','INVALIDATED'],false)}, error_code TEXT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NULL, invalidated_at TEXT NULL,
      UNIQUE(user_id,execution_mode,deterministic_run_key), ${tail('run_id')}`,
    `${header('evidence_items')}
      evidence_item_id TEXT NOT NULL, run_id TEXT NOT NULL, item_key TEXT NOT NULL,
      claim_key TEXT NULL, direction TEXT NULL, unit TEXT NULL, effect REAL NULL, lower_bound REAL NULL, upper_bound REAL NULL,
      raw_significance REAL NULL CHECK(raw_significance BETWEEN 0 AND 1), adjusted_significance REAL NULL CHECK(adjusted_significance BETWEEN 0 AND 1),
      exposed_count INTEGER NULL CHECK(exposed_count >= 0), confirmed_unexposed_count INTEGER NULL CHECK(confirmed_unexposed_count >= 0),
      unknown_count INTEGER NULL CHECK(unknown_count >= 0), effective_sample_count REAL NULL CHECK(effective_sample_count >= 0),
      exposure_classification_version TEXT NOT NULL, factor_set_version TEXT NOT NULL, quality TEXT NULL,
      recency_weight REAL NULL CHECK(recency_weight BETWEEN 0 AND 1), causal_status TEXT NULL,
      ${json('provenance_json')}, ${json('confound_json')}, invalidated_at TEXT NULL, supersedes_item_id TEXT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,execution_mode,run_id,item_key), ${tail('evidence_item_id')}`,
    `${header('observation_episodes')}
      episode_id TEXT NOT NULL, fingerprint TEXT NOT NULL, episode_family_key TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision) = 'integer' AND revision > 0), episode_type TEXT NULL,
      domain TEXT NULL, subject_key TEXT NULL, direction TEXT NULL, ${enumColumn('state',EPISODE_STATES,false)},
      severity INTEGER NULL CHECK(severity >= 0), current_confidence REAL NULL CHECK(current_confidence BETWEEN 0 AND 1),
      current_novelty INTEGER NULL CHECK(current_novelty IN (0,1)), explained_status INTEGER NULL CHECK(explained_status IN (0,1)),
      explanation_evidence_item_id TEXT NULL, explanation_context_id TEXT NULL,
      opened_at TEXT NOT NULL, first_observed_at TEXT NULL, last_observed_at TEXT NULL, last_material_change_at TEXT NULL,
      updated_at TEXT NOT NULL, stabilization_started_at TEXT NULL, resolved_at TEXT NULL, expires_at TEXT NULL,
      invalidated_at TEXT NULL, health_window_start TEXT NULL, health_window_end TEXT NULL, timezone TEXT NULL,
      ${fences}, latest_evidence_item_id TEXT NULL, last_question_id TEXT NULL, last_delivered_notification_id TEXT NULL,
      last_ambiguous_attempt_id TEXT NULL, resolution_reason TEXT NULL, reopens_episode_id TEXT NULL, reverses_episode_id TEXT NULL,
      semantic_summary_hash TEXT NULL, ${json('explanation_json')}, ${json('current_context_json')}, last_semantic_event_id TEXT NULL,
      max_semantic_severity_ordinal INTEGER NULL CHECK(max_semantic_severity_ordinal >= 0), created_at TEXT NOT NULL,
      ${tail('episode_id')}`,
    `${header('episode_observations')}
      episode_id TEXT NOT NULL, observation_key TEXT NOT NULL, source_type TEXT NULL, source_id TEXT NULL, source_version TEXT NULL,
      observed_at TEXT NULL, health_date TEXT NULL, normalized_value REAL NULL, unit TEXT NULL, robust_z REAL NULL,
      meaningfulness REAL NULL, quality TEXT NULL, ${generation('input_generation')}, added_at TEXT NOT NULL, invalidated_at TEXT NULL,
      ${tail('episode_id,observation_key')}`,
    `${header('episode_evidence')}
      episode_id TEXT NOT NULL, evidence_item_id TEXT NOT NULL, episode_revision INTEGER NOT NULL CHECK(episode_revision > 0),
      relationship_type TEXT NULL, linked_at TEXT NOT NULL, unlinked_at TEXT NULL, ${tail('episode_id,evidence_item_id')}`,
    `${header('episode_events')}
      episode_event_id TEXT NOT NULL, deterministic_event_key TEXT NOT NULL, episode_id TEXT NOT NULL,
      ${enumColumn('event_kind',['STATE_TRANSITION','SAME_STATE_REVISION'],false)},
      ${enumColumn('from_state',EPISODE_STATES)}, ${enumColumn('to_state',EPISODE_STATES,false)}, reason TEXT NULL,
      expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0), resulting_revision INTEGER NOT NULL CHECK(resulting_revision = expected_revision + 1),
      ${generation('input_generation')}, ${json('evidence_references_json')}, actor_type TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,execution_mode,deterministic_event_key),
      CHECK((event_kind = 'SAME_STATE_REVISION' AND from_state IS NOT NULL AND from_state = to_state AND to_state IN (${sqlEnum(EPISODE_ACTIVE)}))
        OR (event_kind = 'STATE_TRANSITION' AND from_state IS NOT to_state)), ${tail('episode_event_id')}`,
    `${header('episode_semantic_events')}
      episode_semantic_event_id TEXT NOT NULL, episode_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(resulting_revision > 0),
      episode_event_id TEXT NOT NULL, ${enumColumn('event_kind',['OPENED','ESCALATED','EXPLAINED','MATERIAL_ESCALATION'],false)},
      severity_ordinal INTEGER NULL CHECK(severity_ordinal >= 0), explained_uncertainty_key TEXT NULL,
      claim_key TEXT NULL, recommended_action_key TEXT NULL, semantic_content_hash TEXT NULL,
      predecessor_semantic_event_id TEXT NULL, ${fences}, algorithm_version TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,execution_mode,episode_id,resulting_revision), ${tail('episode_semantic_event_id')}`,
    `${header('insight_revisions')}
      insight_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), ${enumColumn('status',INSIGHT_STATES,false)},
      ${enumColumn('lifecycle_disposition',INSIGHT_DISPOSITIONS)}, normalized_claim TEXT NULL, claim_hash TEXT NULL,
      evidence_contract_version TEXT NOT NULL, ${json('supporting_evidence_ids_json')}, ${json('contradicting_evidence_ids_json')},
      transition_reason TEXT NULL, ${fences}, created_at TEXT NOT NULL,
      CHECK(status <> 'RETIRED' OR lifecycle_disposition IS NOT NULL), ${tail('insight_id,revision')}`,
  ];
  const additions = {
    execution_mode: modeColumn.replace(/^execution_mode /,''), insight_key:'TEXT NULL', current_revision:'INTEGER NULL CHECK(current_revision > 0)',
    evidence_contract_version:'TEXT NULL', lifecycle_disposition:`TEXT NULL CHECK(lifecycle_disposition IN (${sqlEnum(INSIGHT_DISPOSITIONS)}))`,
    expires_at:'TEXT NULL', invalidated_at:'TEXT NULL', lifecycle_generation:'INTEGER NULL CHECK(lifecycle_generation >= 0)',
    auth_generation:'INTEGER NULL CHECK(auth_generation >= 0)', input_generation:'INTEGER NULL CHECK(input_generation >= 0)',
    legacy_classification:"TEXT NULL CHECK(legacy_classification IN ('LEGACY_UNVERIFIED','PHASE4'))",
  };
  const columns = Object.entries(additions).map(([column,definition])=>({table:'health_insights',column,definition}));
  const indexes = [
    schemaIndex('p4_body_checkpoint_tuple','body_energy_checkpoints','user_id,execution_mode,checkpoint_kind,checkpoint_bucket_start,algorithm_version,input_generation',true,"checkpoint_kind = 'PERIODIC_15M'"),
    ...['fingerprint','episode_family_key'].map(key=>schemaIndex(`p4_episode_active_${key}`,'observation_episodes',`user_id,execution_mode,${key}`,true,`state IN (${sqlEnum(EPISODE_ACTIVE)})`)),
    schemaIndex('p4_episode_state','observation_episodes','user_id,execution_mode,state,updated_at'),
    schemaIndex('p4_episode_subject','observation_episodes','user_id,execution_mode,subject_key,health_window_end'),
    schemaIndex('p4_insight_current','health_insights','user_id,execution_mode,insight_key',true,"insight_key IS NOT NULL AND status <> 'RETIRED' AND legacy_classification = 'PHASE4'"),
    schemaIndex('p4_body_date','body_energy_results','user_id,execution_mode,health_date,as_of_epoch_ms DESC'),
    schemaIndex('p4_body_generation','body_energy_results','user_id,execution_mode,input_generation,invalidated_at'),
    schemaIndex('p4_evidence_subject','evidence_runs','user_id,execution_mode,subject_key,as_of_utc'),
    schemaIndex('p4_evidence_state','evidence_runs','user_id,execution_mode,state,input_generation'),
    schemaIndex('p4_evidence_item_run','evidence_items','user_id,execution_mode,run_id'),
    schemaIndex('p4_evidence_item_claim','evidence_items','user_id,execution_mode,claim_key,created_at'),
    schemaIndex('p4_evidence_item_invalid','evidence_items','user_id,execution_mode,invalidated_at'),
    schemaIndex('p4_observation_source','episode_observations','user_id,execution_mode,source_type,source_id,source_version'),
    schemaIndex('p4_episode_evidence_item','episode_evidence','user_id,execution_mode,evidence_item_id'),
    schemaIndex('p4_episode_event_parent','episode_events','user_id,execution_mode,episode_id,created_at'),
    schemaIndex('p4_episode_semantic_parent','episode_semantic_events','user_id,execution_mode,episode_id,resulting_revision'),
    schemaIndex('p4_insight_revision','insight_revisions','user_id,execution_mode,insight_id,revision DESC'),
    schemaIndex('p4_insight_expiry','health_insights','user_id,execution_mode,status,expires_at'),
  ];
  for (const table of V23_TABLES) indexes.push(
    schemaIndex(`p4_${table}_privacy_id`,table,'user_id,execution_mode,privacy_artifact_id',true),
    schemaIndex(`p4_${table}_privacy`,table,'user_id,execution_mode,content_state,purge_generation'));
  // Forward-only index expansion: the v22 definition remains frozen and can
  // still be verified independently. Install the new index before retiring old.
  const replacements = [
    ['p4_health_insights_privacy_id','user_id,execution_mode,privacy_artifact_id',true],
    ['p4_health_insights_privacy','user_id,execution_mode,content_state,purge_generation',false],
    ['idx_insight_subject','user_id,execution_mode,subject,status',false],
    ['idx_insight_active','user_id,execution_mode,status,insight_type',false],
  ].map(([oldName,fields,unique])=>({oldName,ddl:schemaIndex(`${oldName}_v23`,'health_insights',fields,unique)}));
  const triggers = [...V23_TABLES,'health_insights'].map(immutableMode);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_episode_revision_monotonic
    BEFORE UPDATE ON observation_episodes WHEN
      (NEW.revision <> OLD.revision AND NEW.revision <> OLD.revision + 1)
      OR (NEW.state <> OLD.state AND NEW.revision <> OLD.revision + 1)
      OR (OLD.state IN ('RESOLVED','EXPIRED','INVALIDATED') AND (NEW.state <> OLD.state OR NEW.revision <> OLD.revision))
    BEGIN SELECT RAISE(ABORT,'phase4_invalid_episode_revision'); END`);
  for (const [table,fields] of Object.entries(immutableColumns)) {
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_envelope_immutable
      BEFORE UPDATE ON ${table} WHEN ${['user_id','privacy_artifact_id',...fields].map(f=>`NEW.${f} IS NOT OLD.${f}`).join(' OR ')}
      BEGIN SELECT RAISE(ABORT,'phase4_envelope_immutable'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_no_rehydration
      BEFORE UPDATE ON ${table} WHEN OLD.content_state = 'REDACTED' AND NEW.content_state <> 'REDACTED'
      BEGIN SELECT RAISE(ABORT,'phase4_content_redacted'); END`);
    if (table !== 'observation_episodes') triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_content_append_only
      BEFORE UPDATE ON ${table} WHEN NEW.content_state <> 'REDACTED'
        ${table === 'evidence_runs' ? "AND OLD.state <> 'STARTED'" : ''}
        AND (${V23_HEALTH_FIELDS[table].map(f=>`NEW.${f} IS NOT OLD.${f}`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_content_append_only'); END`);
  }
  for (const op of ['INSERT','UPDATE']) {
    for (const [table,fields] of Object.entries(V23_HEALTH_FIELDS)) triggers.push(
      `CREATE TRIGGER IF NOT EXISTS p4_${table}_redaction_${op.toLowerCase()}
        BEFORE ${op} ON ${table} WHEN NEW.content_state = 'REDACTED' AND (${fields.map(f=>`NEW.${f} IS NOT NULL`).join(' OR ')})
        BEGIN SELECT RAISE(ABORT,'phase4_redacted_plaintext'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_body_exact_time_${op.toLowerCase()}
      BEFORE ${op} ON body_energy_results WHEN NEW.content_state = 'PRESENT' AND
        NEW.as_of_epoch_ms BETWEEN -62167219200000 AND 253402300799999 AND
        (strftime('%Y-%m-%dT%H:%M:%fZ',NEW.as_of_epoch_ms / 1000.0,'unixepoch') IS NOT NEW.as_of_utc)
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_exact_as_of'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_checkpoint_parent_${op.toLowerCase()}
      BEFORE ${op} ON body_energy_checkpoints WHEN NEW.content_state = 'PRESENT' AND NOT EXISTS
        (SELECT 1 FROM body_energy_results r WHERE r.user_id = NEW.user_id AND r.execution_mode = NEW.execution_mode
          AND r.result_id = NEW.result_id AND r.algorithm_version = NEW.algorithm_version AND r.input_generation = NEW.input_generation
          AND r.as_of_epoch_ms = NEW.checkpoint_as_of_epoch_ms AND r.content_state = 'PRESENT'
          AND r.source_linkage_state = 'COMPLETE' AND r.invalidated_at IS NULL)
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_checkpoint_parent'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_insight_classification_${op.toLowerCase()}
      BEFORE ${op} ON health_insights WHEN NEW.legacy_classification = 'PHASE4' AND
        (NEW.status NOT IN (${sqlEnum(INSIGHT_STATES)}) OR (NEW.status = 'RETIRED' AND NEW.lifecycle_disposition IS NULL)
          OR NEW.insight_key IS NULL OR NEW.current_revision IS NULL OR NEW.evidence_contract_version IS NULL
          OR NEW.lifecycle_generation IS NULL OR NEW.auth_generation IS NULL OR NEW.input_generation IS NULL)
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_insight_lifecycle'); END`);
    const parents = [
      ['evidence_items','evidence_runs','run_id','run_id'],
      ['episode_observations','observation_episodes','episode_id','episode_id'],
      ['episode_evidence','observation_episodes','episode_id','episode_id'],
      ['episode_evidence','evidence_items','evidence_item_id','evidence_item_id'],
      ['episode_events','observation_episodes','episode_id','episode_id'],
      ['episode_semantic_events','observation_episodes','episode_id','episode_id'],
      ['episode_semantic_events','episode_events','episode_event_id','episode_event_id'],
      ['insight_revisions','health_insights','insight_id','id'],
    ];
    for (const [child,parent,reference,key] of parents) triggers.push(
      `CREATE TRIGGER IF NOT EXISTS p4_${child}_${reference}_parent_${op.toLowerCase()}
        BEFORE ${op} ON ${child} WHEN NEW.content_state = 'PRESENT' AND NOT EXISTS
          (SELECT 1 FROM ${parent} p WHERE p.user_id = NEW.user_id AND p.execution_mode = NEW.execution_mode
            AND p.${key} = NEW.${reference} AND p.content_state = 'PRESENT' AND p.source_linkage_state = 'COMPLETE'
            AND p.health_content_redacted_at IS NULL)
        BEGIN SELECT RAISE(ABORT,'phase4_invalid_same_mode_parent'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_insight_revision_parent_${op.toLowerCase()}
      BEFORE ${op} ON health_insights WHEN NEW.legacy_classification = 'PHASE4' AND NEW.content_state = 'PRESENT' AND NOT EXISTS
        (SELECT 1 FROM insight_revisions r WHERE r.user_id = NEW.user_id AND r.execution_mode = NEW.execution_mode
          AND r.insight_id = NEW.id AND r.revision = NEW.current_revision AND r.status = NEW.status
          AND r.evidence_contract_version = NEW.evidence_contract_version AND r.input_generation = NEW.input_generation
          AND r.lifecycle_generation = NEW.lifecycle_generation AND r.auth_generation = NEW.auth_generation
          AND r.content_state = 'PRESENT' AND r.source_linkage_state = 'COMPLETE')
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_current_insight_revision'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_semantic_event_revision_${op.toLowerCase()}
      BEFORE ${op} ON episode_semantic_events WHEN NEW.content_state = 'PRESENT' AND NOT EXISTS
        (SELECT 1 FROM episode_events e WHERE e.user_id = NEW.user_id AND e.execution_mode = NEW.execution_mode
          AND e.episode_event_id = NEW.episode_event_id AND e.episode_id = NEW.episode_id AND e.resulting_revision = NEW.resulting_revision
          AND ((NEW.event_kind = 'OPENED' AND e.from_state IS NULL AND e.to_state = 'OPEN')
            OR (NEW.event_kind = 'ESCALATED' AND e.event_kind = 'STATE_TRANSITION' AND e.to_state = 'ESCALATED')
            OR (NEW.event_kind = 'EXPLAINED' AND e.event_kind = 'STATE_TRANSITION' AND e.to_state = 'EXPLAINED')
            OR (NEW.event_kind = 'MATERIAL_ESCALATION' AND e.event_kind = 'SAME_STATE_REVISION' AND e.to_state = 'ESCALATED')))
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_semantic_event_revision'); END`);
  }
  return Object.freeze({version:23,ddl,columns,indexes,triggers,replacements});
}
