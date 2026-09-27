import { R_SQL } from './phase4V22Schema.js';
import { privacyChecks, schemaIndex } from './phase4V23Schema.js';

export const OPERATION_RECEIPT_TABLE='phase4_operation_receipts';
export const OPERATION_RECEIPT_VERSION='stage5-operation-result-v1';
export const V27_TABLES=[OPERATION_RECEIPT_TABLE];
export const V27_HEALTH_FIELDS=Object.freeze({[OPERATION_RECEIPT_TABLE]:[
  'semantic_at','request_json','result_json','related_results_json','required_roots_json','schema_contract_json','receipt_hmac',
]});

export function buildV27(modeColumn,immutableMode) {
  const table=OPERATION_RECEIPT_TABLE,health=V27_HEALTH_FIELDS[table];
  const identity=['user_id','operation_kind','operation_key','receipt_version','privacy_artifact_id',
    'input_generation','lifecycle_generation','auth_generation','created_at'];
  const ddl=[`CREATE TABLE IF NOT EXISTS ${table} (
    user_id TEXT NOT NULL, ${modeColumn}, ${R_SQL},
    operation_kind TEXT NOT NULL, operation_key TEXT NOT NULL CHECK(length(operation_key)=64),
    receipt_version TEXT NOT NULL CHECK(receipt_version='${OPERATION_RECEIPT_VERSION}'), semantic_at TEXT NULL,
    ${health.filter(k=>!['receipt_hmac','semantic_at'].includes(k)).map(k=>`${k} TEXT NULL CHECK(${k} IS NULL OR (json_valid(${k}) AND length(${k})<=4194304))`).join(',\n    ')},
    receipt_hmac TEXT NULL CHECK(receipt_hmac IS NULL OR length(receipt_hmac)=64),
    input_generation INTEGER NOT NULL CHECK(typeof(input_generation)='integer' AND input_generation>=0),
    lifecycle_generation INTEGER NOT NULL CHECK(typeof(lifecycle_generation)='integer' AND lifecycle_generation>=0),
    auth_generation INTEGER NOT NULL CHECK(typeof(auth_generation)='integer' AND auth_generation>=0),
    created_at TEXT NOT NULL,
    CHECK(execution_mode='SHADOW'), CHECK(privacy_artifact_id IS NOT NULL),
    CHECK(content_state IN ('PRESENT','REDACTED')),
    CHECK(content_state<>'PRESENT' OR (${health.map(k=>`${k} IS NOT NULL`).join(' AND ')} AND content_digest_salt IS NOT NULL)),
    ${privacyChecks}, PRIMARY KEY(user_id,execution_mode,operation_kind,operation_key)) WITHOUT ROWID`];
  const indexes=[schemaIndex('p4_operation_receipt_privacy_id',table,'user_id,execution_mode,privacy_artifact_id',true),
    schemaIndex('p4_operation_receipt_generation',table,'user_id,execution_mode,input_generation')];
  const triggers=[immutableMode(table),
    `CREATE TRIGGER IF NOT EXISTS p4_operation_receipt_no_replace BEFORE INSERT ON ${table}
      WHEN EXISTS(SELECT 1 FROM ${table} r WHERE r.user_id=NEW.user_id AND r.execution_mode=NEW.execution_mode
        AND ((r.operation_kind=NEW.operation_kind AND r.operation_key=NEW.operation_key) OR r.privacy_artifact_id=NEW.privacy_artifact_id))
      BEGIN SELECT RAISE(ABORT,'phase4_operation_receipt_conflict'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_operation_receipt_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'phase4_operation_receipt_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_operation_receipt_identity BEFORE UPDATE ON ${table}
      WHEN ${identity.map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
      BEGIN SELECT RAISE(ABORT,'phase4_operation_receipt_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_operation_receipt_content BEFORE UPDATE ON ${table}
      WHEN NEW.content_state<>'REDACTED' AND (${[...health,'content_digest_salt','purge_generation'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_operation_receipt_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_operation_receipt_no_rehydration BEFORE UPDATE ON ${table}
      WHEN (OLD.content_state='REDACTED' AND NEW.content_state<>'REDACTED') OR NEW.purge_generation<OLD.purge_generation
      BEGIN SELECT RAISE(ABORT,'phase4_content_redacted'); END`];
  for(const op of ['INSERT','UPDATE'])triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_operation_receipt_redaction_${op.toLowerCase()} BEFORE ${op} ON ${table}
    WHEN NEW.content_state='REDACTED' AND (${health.map(k=>`NEW.${k} IS NOT NULL`).join(' OR ')})
    BEGIN SELECT RAISE(ABORT,'phase4_redacted_plaintext'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_health_insights_no_rehydration_v27 BEFORE UPDATE ON health_insights
    WHEN OLD.content_state='REDACTED' AND NEW.content_state<>'REDACTED'
    BEGIN SELECT RAISE(ABORT,'phase4_content_redacted'); END`);
  for(const op of ['INSERT','UPDATE'])triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_health_insights_redaction_v27_${op.toLowerCase()} BEFORE ${op} ON health_insights
    WHEN NEW.content_state='REDACTED' AND (NEW.statement IS NOT '[HEALTH_CONTENT_REDACTED]'
      OR NEW.subject IS NOT '[HEALTH_CONTENT_REDACTED]' OR NEW.insight_type IS NOT '[HEALTH_CONTENT_REDACTED]'
      OR NEW.evidence_json IS NOT '{}' OR NEW.sample_count IS NOT NULL OR NEW.effect_size IS NOT NULL OR NEW.confidence IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'phase4_redacted_plaintext'); END`);
  return Object.freeze({version:27,ddl,indexes,triggers});
}
