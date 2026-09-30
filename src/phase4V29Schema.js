export const ROUTE_VERSION='stage6-receipt-routing-v1';
export const ROUTE_RECEIPTS='phase4_receipt_routes';
export const ROUTE_ENTRIES='phase4_receipt_route_entries';
export const ROUTE_MANIFESTS='phase4_receipt_route_manifests';
export const V29_TABLES=[ROUTE_RECEIPTS,ROUTE_ENTRIES,ROUTE_MANIFESTS];

/** Routing contains keyed, opaque identifiers only. It is deliberately outside
 * the health-content redaction inventory, so a completed purge cannot erase
 * the evidence that a redacted v27 receipt belonged to a subject. */
export function buildV29(modeColumn,immutableMode) {
  const ddl=[
    `CREATE TABLE IF NOT EXISTS ${ROUTE_RECEIPTS} (
      user_id TEXT NOT NULL, ${modeColumn}, operation_kind TEXT NOT NULL, operation_key TEXT NOT NULL,
      route_version TEXT NOT NULL CHECK(route_version='${ROUTE_VERSION}'),
      route_state TEXT NOT NULL CHECK(route_state IN ('KNOWN','LEGACY_ROUTE_UNKNOWN')),
      subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json)), route_hmac TEXT NOT NULL CHECK(length(route_hmac)=64),
      created_at TEXT NOT NULL, PRIMARY KEY(user_id,execution_mode,operation_kind,operation_key),
      FOREIGN KEY(user_id,execution_mode,operation_kind,operation_key)
        REFERENCES phase4_operation_receipts(user_id,execution_mode,operation_kind,operation_key) DEFERRABLE INITIALLY DEFERRED,
      CHECK(execution_mode='SHADOW')) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${ROUTE_ENTRIES} (
      user_id TEXT NOT NULL, ${modeColumn}, subject_kind TEXT NOT NULL, subject_token TEXT NOT NULL CHECK(length(subject_token)=64),
      sequence INTEGER NOT NULL CHECK(sequence>0), operation_kind TEXT NOT NULL, operation_key TEXT NOT NULL,
      route_version TEXT NOT NULL CHECK(route_version='${ROUTE_VERSION}'),
      binding_hmac TEXT NOT NULL CHECK(length(binding_hmac)=64),
      PRIMARY KEY(user_id,execution_mode,subject_kind,subject_token,sequence),
      UNIQUE(user_id,execution_mode,operation_kind,operation_key,subject_kind,subject_token),
      FOREIGN KEY(user_id,execution_mode,operation_kind,operation_key)
        REFERENCES ${ROUTE_RECEIPTS}(user_id,execution_mode,operation_kind,operation_key) DEFERRABLE INITIALLY DEFERRED,
      CHECK(execution_mode='SHADOW')) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${ROUTE_MANIFESTS} (
      user_id TEXT NOT NULL, ${modeColumn}, subject_kind TEXT NOT NULL, subject_token TEXT NOT NULL CHECK(length(subject_token)=64),
      route_version TEXT NOT NULL CHECK(route_version='${ROUTE_VERSION}'),
      entry_count INTEGER NOT NULL CHECK(entry_count>0), chain_digest TEXT NOT NULL CHECK(length(chain_digest)=64),
      manifest_hmac TEXT NOT NULL CHECK(length(manifest_hmac)=64),
      PRIMARY KEY(user_id,execution_mode,subject_kind,subject_token), CHECK(execution_mode='SHADOW')) WITHOUT ROWID`,
  ];
  const indexes=[`CREATE INDEX IF NOT EXISTS p4_route_entry_receipt ON ${ROUTE_ENTRIES}
    (user_id,execution_mode,operation_kind,operation_key)`];
  const triggers=[...V29_TABLES.map(immutableMode),
    ...V29_TABLES.map(table=>`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'phase4_route_immutable'); END`),
    ...[ROUTE_RECEIPTS,ROUTE_ENTRIES].map(table=>`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'phase4_route_immutable'); END`),
    `CREATE TRIGGER IF NOT EXISTS ${ROUTE_MANIFESTS}_identity BEFORE UPDATE ON ${ROUTE_MANIFESTS}
      WHEN NEW.user_id IS NOT OLD.user_id OR NEW.execution_mode IS NOT OLD.execution_mode
        OR NEW.subject_kind IS NOT OLD.subject_kind OR NEW.subject_token IS NOT OLD.subject_token
        OR NEW.route_version IS NOT OLD.route_version OR NEW.entry_count<>OLD.entry_count+1
      BEGIN SELECT RAISE(ABORT,'phase4_route_immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS p4_receipt_requires_route_v29 BEFORE INSERT ON phase4_operation_receipts
      WHEN NOT EXISTS(SELECT 1 FROM ${ROUTE_RECEIPTS} r WHERE r.user_id=NEW.user_id
        AND r.execution_mode=NEW.execution_mode AND r.operation_kind=NEW.operation_kind
        AND r.operation_key=NEW.operation_key AND r.route_state='KNOWN')
      BEGIN SELECT RAISE(ABORT,'phase4_receipt_route_required'); END`,
  ];
  return Object.freeze({version:29,ddl,indexes,triggers});
}
