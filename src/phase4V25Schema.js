import { R_SQL } from './phase4V22Schema.js';
import { privacyChecks, schemaIndex, V23_HEALTH_FIELDS } from './phase4V23Schema.js';

export const V25_TABLES = ['phase4_episode_revisions'];
export const V25_HEALTH_FIELDS = Object.freeze({phase4_episode_revisions:['semantic_at','snapshot_json','snapshot_hash']});
export const EPISODE_SNAPSHOT_VERSION = 'episode-revision-v1';

export function buildV25(modeColumn, immutableMode) {
  const table='phase4_episode_revisions';
  const ddl=[`CREATE TABLE IF NOT EXISTS ${table} (
    user_id TEXT NOT NULL, ${modeColumn}, ${R_SQL},
    episode_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
    episode_event_id TEXT NOT NULL,
    snapshot_version TEXT NOT NULL CHECK(snapshot_version = '${EPISODE_SNAPSHOT_VERSION}'),
    semantic_at TEXT NULL,
    snapshot_json TEXT NULL CHECK(length(snapshot_json) <= 1048576),
    snapshot_hash TEXT NULL CHECK(length(snapshot_hash) = 64),
    input_generation INTEGER NOT NULL CHECK(typeof(input_generation) = 'integer' AND input_generation >= 0),
    lifecycle_generation INTEGER NOT NULL CHECK(typeof(lifecycle_generation) = 'integer' AND lifecycle_generation >= 0),
    auth_generation INTEGER NOT NULL CHECK(typeof(auth_generation) = 'integer' AND auth_generation >= 0),
    created_at TEXT NOT NULL,
    CHECK(content_state <> 'PRESENT' OR (semantic_at IS NOT NULL AND snapshot_json IS NOT NULL
      AND json_valid(snapshot_json) AND snapshot_hash IS NOT NULL AND content_digest_salt IS NOT NULL)),
    ${privacyChecks}, PRIMARY KEY(user_id,execution_mode,episode_id,revision),
    UNIQUE(user_id,execution_mode,episode_event_id))`];
  const indexes=[
    schemaIndex('p4_episode_revision_privacy_id',table,'user_id,execution_mode,privacy_artifact_id',true),
    schemaIndex('p4_episode_revision_privacy',table,'user_id,execution_mode,content_state,purge_generation'),
    schemaIndex('p4_episode_revision_time',table,'user_id,execution_mode,episode_id,semantic_at'),
    schemaIndex('p4_episode_event_revision_v25','episode_events','user_id,execution_mode,episode_id,resulting_revision',true),
  ];
  const identity=['user_id','episode_id','revision','episode_event_id','snapshot_version','privacy_artifact_id',
    'input_generation','lifecycle_generation','auth_generation','created_at'];
  const health=V25_HEALTH_FIELDS[table];
  const semanticFields=[...V23_HEALTH_FIELDS.observation_episodes,'state','opened_at','resolved_at','expires_at','invalidated_at',
    'latest_evidence_item_id','resolution_reason','semantic_summary_hash','last_semantic_event_id',
    'input_generation','lifecycle_generation','auth_generation'];
  const triggers=[immutableMode(table),
    `CREATE TRIGGER IF NOT EXISTS p4_episode_metric_identity_immutable BEFORE UPDATE ON observation_episodes
      WHEN NEW.content_state <> 'REDACTED' AND (NEW.domain IS NOT OLD.domain
        OR NEW.subject_key IS NOT OLD.subject_key OR NEW.direction IS NOT OLD.direction)
      BEGIN SELECT RAISE(ABORT,'phase4_episode_identity_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_episode_committed_revision_immutable BEFORE UPDATE ON observation_episodes
      WHEN NEW.content_state <> 'REDACTED' AND NEW.revision = OLD.revision
        AND EXISTS (SELECT 1 FROM phase4_episode_revisions h WHERE h.user_id=OLD.user_id
          AND h.execution_mode=OLD.execution_mode AND h.episode_id=OLD.episode_id AND h.revision=OLD.revision)
        AND (${semanticFields.map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_episode_revision_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_episode_revision_envelope_immutable BEFORE UPDATE ON ${table}
      WHEN ${identity.map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
      BEGIN SELECT RAISE(ABORT,'phase4_envelope_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_episode_revision_content_append_only BEFORE UPDATE ON ${table}
      WHEN NEW.content_state <> 'REDACTED' AND (${[...health,'content_digest_salt','purge_generation'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_content_append_only'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_episode_revision_no_rehydration BEFORE UPDATE ON ${table}
      WHEN OLD.content_state = 'REDACTED' AND NEW.content_state <> 'REDACTED'
      BEGIN SELECT RAISE(ABORT,'phase4_content_redacted'); END`,
  ];
  for(const op of ['INSERT','UPDATE']) {
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_episode_revision_redaction_${op.toLowerCase()} BEFORE ${op} ON ${table}
      WHEN NEW.content_state = 'REDACTED' AND (${health.map(k=>`NEW.${k} IS NOT NULL`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_redacted_plaintext'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_episode_revision_parent_${op.toLowerCase()} BEFORE ${op} ON ${table}
      WHEN NEW.content_state = 'PRESENT' AND NOT EXISTS (
        SELECT 1 FROM observation_episodes p JOIN episode_events e
          ON e.user_id=p.user_id AND e.execution_mode=p.execution_mode AND e.episode_id=p.episode_id
        WHERE p.user_id=NEW.user_id AND p.execution_mode=NEW.execution_mode AND p.episode_id=NEW.episode_id
          AND p.content_state='PRESENT' AND p.source_linkage_state='COMPLETE'
          AND p.input_generation=NEW.input_generation AND p.lifecycle_generation=NEW.lifecycle_generation
          AND p.auth_generation=NEW.auth_generation AND e.episode_event_id=NEW.episode_event_id
          AND e.resulting_revision=NEW.revision AND e.input_generation=NEW.input_generation
          AND e.content_state='PRESENT' AND e.source_linkage_state='COMPLETE')
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_revision_parent'); END`);
  }
  // Privacy invalidation is a tombstone operation, not a new semantic revision.
  // Keep frozen v23 verifiable and replace its trigger forward-only in v25.
  const replacements=[{oldName:'p4_episode_revision_monotonic',kind:'TRIGGER',
    ddl:`CREATE TRIGGER IF NOT EXISTS p4_episode_revision_monotonic_v25
      BEFORE UPDATE ON observation_episodes WHEN
        (NEW.revision <> OLD.revision AND NEW.revision <> OLD.revision + 1)
        OR (NEW.state <> OLD.state AND NEW.revision <> OLD.revision + 1
          AND NOT (NEW.content_state = 'REDACTED' AND NEW.state = 'INVALIDATED' AND NEW.revision = OLD.revision))
        OR (OLD.state IN ('RESOLVED','EXPIRED','INVALIDATED') AND (NEW.state <> OLD.state OR NEW.revision <> OLD.revision))
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_episode_revision'); END`}];
  return Object.freeze({version:25,ddl,indexes,triggers,replacements});
}
