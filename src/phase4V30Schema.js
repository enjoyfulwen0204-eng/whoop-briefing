export const FAMILY_DIRECTORY_VERSION='stage6-family-directory-v1';
export const FAMILY_DIRECTORY_ENTRIES='phase4_family_directory_entries';
export const FAMILY_DIRECTORY_MANIFESTS='phase4_family_directory_manifests';
export const FAMILY_WORK_TIPS='phase4_family_work_tips';
export const V30_TABLES=[FAMILY_DIRECTORY_ENTRIES,FAMILY_DIRECTORY_MANIFESTS,FAMILY_WORK_TIPS];

/** The directory is monotone. Work tips are operational checkpoints, not
 * episode lifecycle facts. All three tables are SHADOW-only. */
export function buildV30(modeColumn,immutableMode) {
  const ddl=[
    `CREATE TABLE IF NOT EXISTS ${FAMILY_DIRECTORY_ENTRIES} (
      user_id TEXT NOT NULL, ${modeColumn}, source_token TEXT NOT NULL CHECK(length(source_token)=64),
      sequence INTEGER NOT NULL CHECK(sequence>0), family_token TEXT NOT NULL CHECK(length(family_token)=64),
      family_key TEXT NULL CHECK(family_key IS NULL OR length(family_key)=64),
      descriptor_json TEXT NULL CHECK(descriptor_json IS NULL OR json_valid(descriptor_json)),
      entry_state TEXT NOT NULL CHECK(entry_state IN ('KNOWN','LEGACY_FAMILY_UNKNOWN')),
      directory_version TEXT NOT NULL CHECK(directory_version='${FAMILY_DIRECTORY_VERSION}'),
      entry_hmac TEXT NOT NULL CHECK(length(entry_hmac)=64),
      PRIMARY KEY(user_id,execution_mode,source_token,sequence),
      UNIQUE(user_id,execution_mode,source_token,family_token),
      CHECK((entry_state='KNOWN' AND family_key IS NOT NULL AND descriptor_json IS NOT NULL)
        OR (entry_state='LEGACY_FAMILY_UNKNOWN' AND descriptor_json IS NULL)),
      CHECK(execution_mode='SHADOW')) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${FAMILY_DIRECTORY_MANIFESTS} (
      user_id TEXT NOT NULL, ${modeColumn}, source_token TEXT NOT NULL CHECK(length(source_token)=64),
      entry_count INTEGER NOT NULL CHECK(entry_count>=0),
      chain_digest TEXT NOT NULL CHECK(length(chain_digest)=64),
      route_tip_json TEXT NOT NULL CHECK(json_valid(route_tip_json)),
      directory_state TEXT NOT NULL CHECK(directory_state IN ('COMPLETE','LEGACY_DIRECTORY_UNKNOWN')),
      directory_version TEXT NOT NULL CHECK(directory_version='${FAMILY_DIRECTORY_VERSION}'),
      manifest_hmac TEXT NOT NULL CHECK(length(manifest_hmac)=64),
      PRIMARY KEY(user_id,execution_mode,source_token), CHECK(execution_mode='SHADOW')) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${FAMILY_WORK_TIPS} (
      user_id TEXT NOT NULL, ${modeColumn}, source_token TEXT NOT NULL CHECK(length(source_token)=64),
      family_token TEXT NOT NULL CHECK(length(family_token)=64),
      requested_json TEXT NOT NULL CHECK(json_valid(requested_json)),
      completed_json TEXT NULL CHECK(completed_json IS NULL OR json_valid(completed_json)),
      family_manifest_json TEXT NULL CHECK(family_manifest_json IS NULL OR json_valid(family_manifest_json)),
      work_version TEXT NOT NULL CHECK(work_version='${FAMILY_DIRECTORY_VERSION}'),
      tip_hmac TEXT NOT NULL CHECK(length(tip_hmac)=64),
      PRIMARY KEY(user_id,execution_mode,source_token,family_token),
      FOREIGN KEY(user_id,execution_mode,source_token,family_token)
        REFERENCES ${FAMILY_DIRECTORY_ENTRIES}(user_id,execution_mode,source_token,family_token)
        DEFERRABLE INITIALLY DEFERRED,
      CHECK(execution_mode='SHADOW')) WITHOUT ROWID`,
  ];
  const triggers=[...V30_TABLES.map(immutableMode),
    `CREATE TRIGGER IF NOT EXISTS ${FAMILY_DIRECTORY_ENTRIES}_no_update BEFORE UPDATE ON ${FAMILY_DIRECTORY_ENTRIES}
      BEGIN SELECT RAISE(ABORT,'phase4_family_directory_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${FAMILY_DIRECTORY_ENTRIES}_no_delete BEFORE DELETE ON ${FAMILY_DIRECTORY_ENTRIES}
      BEGIN SELECT RAISE(ABORT,'phase4_family_directory_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${FAMILY_DIRECTORY_MANIFESTS}_no_delete BEFORE DELETE ON ${FAMILY_DIRECTORY_MANIFESTS}
      BEGIN SELECT RAISE(ABORT,'phase4_family_directory_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${FAMILY_DIRECTORY_MANIFESTS}_monotone BEFORE UPDATE ON ${FAMILY_DIRECTORY_MANIFESTS}
      WHEN NEW.user_id IS NOT OLD.user_id OR NEW.execution_mode IS NOT OLD.execution_mode
        OR NEW.source_token IS NOT OLD.source_token OR NEW.directory_version IS NOT OLD.directory_version
        OR NEW.entry_count<OLD.entry_count OR NEW.entry_count>OLD.entry_count+1
        OR (OLD.directory_state='LEGACY_DIRECTORY_UNKNOWN' AND NEW.directory_state='COMPLETE')
      BEGIN SELECT RAISE(ABORT,'phase4_family_directory_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${FAMILY_WORK_TIPS}_no_delete BEFORE DELETE ON ${FAMILY_WORK_TIPS}
      BEGIN SELECT RAISE(ABORT,'phase4_family_work_immutable'); END`,
  ];
  return Object.freeze({version:30,ddl,indexes:[],triggers});
}
