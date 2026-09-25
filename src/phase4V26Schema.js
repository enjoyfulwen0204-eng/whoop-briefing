import { R_SQL } from './phase4V22Schema.js';
import { privacyChecks, schemaIndex } from './phase4V23Schema.js';

export const RESULT_AUTHORITY_VERSION='evidence-result-authority-v1';
export const RESULT_ROOT_VERSION='stage5-required-roots-v1';
export const RESULT_AUTHORITY_TABLE='phase4_evidence_result_authorities';
export const V26_TABLES=[RESULT_AUTHORITY_TABLE];
export const V26_HEALTH_FIELDS=Object.freeze({[RESULT_AUTHORITY_TABLE]:[
  'original_result_json','required_roots_json','input_manifest_hash','item_hash','authority_hmac',
]});

export function buildV26(modeColumn,immutableMode) {
  const table=RESULT_AUTHORITY_TABLE,health=V26_HEALTH_FIELDS[table];
  const ddl=[`CREATE TABLE IF NOT EXISTS ${table} (
    user_id TEXT NOT NULL, ${modeColumn}, ${R_SQL},
    evidence_item_id TEXT NOT NULL, run_id TEXT NOT NULL,
    result_scope TEXT NOT NULL CHECK(result_scope IN ('METRIC','INSIGHT_CURRENT','INSIGHT_CONTRADICTION')),
    authority_version TEXT NOT NULL CHECK(authority_version='${RESULT_AUTHORITY_VERSION}'),
    original_result_json TEXT NULL CHECK(length(original_result_json)<=1048576),
    required_roots_json TEXT NULL CHECK(length(required_roots_json)<=1048576),
    input_manifest_hash TEXT NULL CHECK(length(input_manifest_hash)=64),
    item_hash TEXT NULL CHECK(length(item_hash)=64),
    authority_hmac TEXT NULL CHECK(length(authority_hmac)=64),
    input_generation INTEGER NOT NULL CHECK(typeof(input_generation)='integer' AND input_generation>=0),
    lifecycle_generation INTEGER NOT NULL CHECK(typeof(lifecycle_generation)='integer' AND lifecycle_generation>=0),
    auth_generation INTEGER NOT NULL CHECK(typeof(auth_generation)='integer' AND auth_generation>=0),
    created_at TEXT NOT NULL,
    CHECK(execution_mode='SHADOW'),
    CHECK(privacy_artifact_id IS NOT NULL),
    CHECK(content_state IN ('PRESENT','REDACTED')),
    CHECK(content_state<>'PRESENT' OR (original_result_json IS NOT NULL AND json_valid(original_result_json)
      AND required_roots_json IS NOT NULL AND json_valid(required_roots_json) AND input_manifest_hash IS NOT NULL
      AND item_hash IS NOT NULL AND authority_hmac IS NOT NULL AND content_digest_salt IS NOT NULL)),
    ${privacyChecks}, PRIMARY KEY(user_id,execution_mode,evidence_item_id,result_scope)) WITHOUT ROWID`];
  const indexes=[schemaIndex('p4_result_authority_privacy_id',table,'user_id,execution_mode,privacy_artifact_id',true),
    schemaIndex('p4_result_authority_run',table,'user_id,execution_mode,run_id'),
    schemaIndex('p4_result_authority_privacy',table,'user_id,execution_mode,content_state,purge_generation')];
  const identity=['user_id','evidence_item_id','run_id','result_scope','authority_version','privacy_artifact_id',
    'input_generation','lifecycle_generation','auth_generation','created_at'];
  const triggers=[immutableMode(table),
    `CREATE TRIGGER IF NOT EXISTS p4_result_authority_no_replace BEFORE INSERT ON ${table}
      WHEN EXISTS(SELECT 1 FROM ${table} a WHERE a.user_id=NEW.user_id AND a.execution_mode=NEW.execution_mode
        AND ((a.evidence_item_id=NEW.evidence_item_id AND a.result_scope=NEW.result_scope)
          OR a.privacy_artifact_id=NEW.privacy_artifact_id))
      BEGIN SELECT RAISE(ABORT,'phase4_result_authority_conflict'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_result_authority_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'phase4_result_authority_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_result_authority_identity BEFORE UPDATE ON ${table}
      WHEN ${identity.map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
      BEGIN SELECT RAISE(ABORT,'phase4_result_authority_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_result_authority_content BEFORE UPDATE ON ${table}
      WHEN NEW.content_state<>'REDACTED' AND (${[...health,'content_digest_salt','purge_generation'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_result_authority_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_result_authority_no_rehydration BEFORE UPDATE ON ${table}
      WHEN (OLD.content_state='REDACTED' AND NEW.content_state<>'REDACTED') OR NEW.purge_generation<OLD.purge_generation
      BEGIN SELECT RAISE(ABORT,'phase4_content_redacted'); END`,
  ];
  for(const op of ['INSERT','UPDATE']) {
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_result_authority_redaction_${op.toLowerCase()} BEFORE ${op} ON ${table}
      WHEN NEW.content_state='REDACTED' AND (${health.map(k=>`NEW.${k} IS NOT NULL`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_redacted_plaintext'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_result_authority_parent_${op.toLowerCase()} BEFORE ${op} ON ${table}
      WHEN NEW.content_state='PRESENT' AND NOT EXISTS(SELECT 1 FROM evidence_items i JOIN evidence_runs r
        ON r.user_id=i.user_id AND r.execution_mode=i.execution_mode AND r.run_id=i.run_id
        WHERE i.user_id=NEW.user_id AND i.execution_mode=NEW.execution_mode AND i.evidence_item_id=NEW.evidence_item_id
          AND r.run_id=NEW.run_id AND r.state='COMPLETED' AND i.content_state='PRESENT' AND r.content_state='PRESENT'
          AND r.input_generation=NEW.input_generation AND r.lifecycle_generation=NEW.lifecycle_generation
          AND r.auth_generation=NEW.auth_generation)
      BEGIN SELECT RAISE(ABORT,'phase4_result_authority_parent'); END`);
  }
  return Object.freeze({version:26,ddl,indexes,triggers});
}
